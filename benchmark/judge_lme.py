import os
import sys
import json
import re
from tqdm import tqdm
import backoff
import openai
from openai import OpenAI
import numpy as np
from datasets import load_dataset, load_from_disk

import dotenv
dotenv.load_dotenv()


#@backoff.on_exception(backoff.expo, (openai.RateLimitError, openai.APIError))
def chat_completions_with_backoff(client, **kwargs):
    return client.chat.completions.create(**kwargs)


def get_anscheck_prompt(task, question, answer, response, abstention=False):
    if not abstention:
        if task in ['single-session-user', 'single-session-assistant', 'multi-session']:
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'temporal-reasoning':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'knowledge-update':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'single-session-preference':
            template = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        else:
            raise NotImplementedError
    else:
        template = "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only."
        prompt = template.format(question, answer, response) 
    return prompt


def load_references_from_huggingface(huggingface_dataset_name, source_dataset_name):
    """
    Load and process reference data from a Hugging Face dataset.

    Args:
        huggingface_dataset_name (str): The name of the Hugging Face dataset.
        source_dataset_name (str): The source name to filter by in the dataset's metadata.

    Returns:
        list: A list of dictionaries, where each dictionary represents a question-answer pair.
    """
    print(f"Loading data from Hugging Face dataset: {huggingface_dataset_name}, split: Accurate_Retrieval")
    # Load the full dataset for the 'Accurate_Retrieval' split
    full_dataset = load_dataset(huggingface_dataset_name, split='Accurate_Retrieval', revision="main")

    # Filter the dataset to get entries matching the specified dataset source
    print(f"Filtering for source: {source_dataset_name}")
    filtered_dataset = full_dataset.filter(lambda example: example['metadata']['source'] == source_dataset_name)

    # Process the filtered data to create a flat list of question-answer pairs
    # This is necessary because each entry in the Hugging Face dataset can contain multiple QA pairs.
    references = []
    for entry in filtered_dataset:
        # Ensure all lists within an entry have the same number of items
        num_questions = len(entry['questions'])
        if not (num_questions == len(entry['answers']) and \
                num_questions == len(entry['metadata']['question_ids']) and \
                num_questions == len(entry['metadata']['question_types'])):
            print(f"Warning: Skipping entry due to mismatched lengths in QA data. Question IDs: {entry['metadata']['question_ids']}")
            continue

        # Unpack each QA pair into a separate dictionary
        for i in range(num_questions):
            references.append({
                'question': entry['questions'][i],
                'answer': entry['answers'][i],
                'question_id': entry['metadata']['question_ids'][i],
                'question_type': entry['metadata']['question_types'][i],
                'context': entry['context']  # Preserve context
            })
    print(f"Loaded and processed {len(references)} references from source '{source_dataset_name}'.")
    return references


if __name__ == '__main__':
    from argparse import ArgumentParser
    parser = ArgumentParser()
    parser.add_argument('--evaluated_method', type=str, default='gpt-4o-mini')
    parser.add_argument('--huggingface_dataset_name', type=str, default="ai-hyz/MemoryAgentBench")
    parser.add_argument('--dataset', type=str, default='longmemeval_s*')
    parser.add_argument('--output_dir', type=str, default='./outputs/')
    parser.add_argument('--hyp_file', type=str, default=None,
                        help='explicit results JSON path (mini/subset runs); bypasses the folder walk '
                             'and matches hypotheses to references by question text instead of position')
    args = parser.parse_args()

    verbose = True
    metric_model=os.environ.get("JUDGE_MODEL", "deepseek-v4-flash")
    # OpenCode Go 要求会话头（其邮件通知：09/06 起缺失可能报错）——
    # 一个稳定 ID 贯穿一次评测即可；对 DeepSeek 官方端点无害。
    judge_base = os.environ.get("JUDGE_BASE_URL", "https://api.deepseek.com/v1")
    judge_headers = {"x-opencode-session": "memoplus4dsh-judge"} if "opencode" in judge_base else None
    metric_client = OpenAI(base_url=judge_base, api_key=os.environ["DEEPSEEK_API_KEY"], default_headers=judge_headers)
    hyp_folder = f'./outputs/{args.evaluated_method}/Accurate_Retrieval'
    
    # make the output dir
    args.output_dir = os.path.join(args.output_dir, args.dataset)
    os.makedirs(args.output_dir, exist_ok=True)
    
    ## find the json file in the folder
    print('Evaluating method:', args.evaluated_method)
    if args.hyp_file is not None:
        hyp_file = args.hyp_file
        with open(hyp_file, 'r', encoding='utf-8') as f:
            hypotheses = (json.load(f))["data"]
        hyper_file_tag = hyp_file.split('/')[-1].split('.')[0]
        result_file = os.path.join(args.output_dir, '.eval-results-{}-{}'.format(args.evaluated_method, hyper_file_tag))
        references = load_references_from_huggingface(args.huggingface_dataset_name, args.dataset)
    elif args.dataset == 'longmemeval_s':
        for root, _, files in os.walk(hyp_folder):
            for file in files:
                if file.endswith('.json') and 'longmemeval_s_' in file and "*" not in file:
                    hyp_file = os.path.join(root, file)
        with open(hyp_file, 'r', encoding='utf-8') as f:
            hypotheses = (json.load(f))["data"]
        
        hyper_file_tag = hyp_file.split('/')[-1].split('.')[0]
        result_file = os.path.join(args.output_dir, '.eval-results-{}-{}'.format(args.evaluated_method, hyper_file_tag))
        references = load_references_from_huggingface(args.huggingface_dataset_name, args.dataset)
    elif args.dataset == 'longmemeval_s*':          
        for root, _, files in os.walk(hyp_folder):
            for file in files:
                if 'longmemeval_s*_' in file:
                    hyp_file = os.path.join(root, file)
        
        print('Hypothesis file:', hyp_file)
        with open(hyp_file, 'r', encoding='utf-8') as f:
            hypotheses = (json.load(f))["data"]
        
        hyper_file_tag = hyp_file.split('/')[-1].split('.')[0]
        result_file = os.path.join(args.output_dir, '.eval-results-{}-{}'.format(args.evaluated_method, hyper_file_tag))
        references = load_references_from_huggingface(args.huggingface_dataset_name, args.dataset)
            
    ### make sure every question from references and hypotheses are the same
    qid2qdata = {entry['question_id']: entry for entry in references}
    qid2qtype = {entry['question_id']: entry['question_type'] for entry in references}
    qtypes = set(list(qid2qtype.values()))
    qtype2acc = {t: [] for t in qtypes}

    def _norm_q(text):
        return ' '.join(str(text).split()).strip().lower()

    def _strip_wrapper(text):
        # both our query template and the reference 'question' field carry
        # the "Current Date: … Now Answer the Question: <q>" wrapper
        q = str(text)
        marker = 'Now Answer the Question:'
        if marker in q:
            q = q.split(marker, 1)[1]
        q = re.sub(r'\s*Answer:\s*$', '', q)
        return _norm_q(q)

    def _hyp_question(hyp):
        return _strip_wrapper(hyp.get('query', ''))

    # Full runs align positionally; subset (mini) runs match by question text.
    if len(hypotheses) == len(references):
        pairs = list(zip(references, hypotheses))
    else:
        ref_by_q = {}
        for r in references:
            ref_by_q.setdefault(_strip_wrapper(r['question']), r)
        pairs = []
        for h in hypotheses:
            ref = ref_by_q.get(_hyp_question(h))
            if ref is None:
                print('Warning: no reference match for hypothesis question:', str(h.get('query'))[-120:])
                continue
            if ref['answer'] != h['answer']:
                print('Warning: answer mismatch for matched question; skipping.')
                continue
            pairs.append((ref, h))
        print(f'Subset mode: matched {len(pairs)}/{len(hypotheses)} hypotheses to references')

    if not os.path.exists(result_file):
        with open(result_file, 'w') as out_f:
            logs = []
            for entry, hyp_entry in tqdm(pairs, total=len(pairs)):
                if entry['question_id'] not in qid2qtype:
                    print('Warning: skipping {} as it is not in reference data.'.format(entry['question_id']))
                    continue

                qtype = qid2qtype[entry['question_id']]
                q = qid2qdata[entry['question_id']]['question']
                ans = qid2qdata[entry['question_id']]['answer']
                hyp = hyp_entry['output']
                ans2 = hyp_entry['answer']
                if ans2 != ans:
                    print("ans2 != ans, please check the data.")
                    print('Reference answer:', ans)
                    print('Hypothesis answer:', ans2)
                    raise ValueError('Answer in the hypothesis does not match the reference answer. Please check the data.')
                
                prompt = get_anscheck_prompt(qtype, q, ans, hyp, abstention='_abs' in entry['question_id'])
                kwargs = {
                    'model': metric_model,
                    'messages':[
                        {"role": "user", "content": prompt}
                    ],
                    'n': 1,
                    'temperature': 0,
                    'max_tokens': 10,
                    'extra_body': {'thinking': {'type': 'disabled'}}  # v4-flash thinks by default; 10 tokens would be consumed by reasoning (F-1 pattern)
                }
                completion = chat_completions_with_backoff(metric_client, **kwargs)
                eval_response = completion.choices[0].message.content.strip()
                label = 'yes' in eval_response.lower()
                entry['autoeval_label'] = {
                    'model': metric_model,
                    'label': label
                }
                ## entry without context
                entry['context'] = None
                logs.append(entry)
                if verbose:
                    print(json.dumps({
                        'question': q,
                        'answer': ans,
                        'hypothesis': hyp,
                        'autoeval_label': label
                    }, indent=4), flush=True)
                print(json.dumps(entry), file=out_f)
                qtype2acc[qid2qtype[entry['question_id']]].append(1 if label else 0)

                
        print('Accuracy:', round(np.mean([1 if x['autoeval_label']['label'] else 0 for x in logs]).item(), 4))
        for k,v in qtype2acc.items():
            print('\t{}: {} ({})'.format(k, round(np.mean(v), 4), len(v)))

        print('Saved to', result_file)
    else:
        print('Result file already exists. Skipping evaluation.')
        with open(result_file, 'r') as out_f:
            logs = [json.loads(line) for line in out_f.readlines()]
        print('Accuracy:', round(np.mean([1 if x['autoeval_label']['label'] else 0 for x in logs]).item(), 4))
        for log in logs:
            qtype2acc[qid2qtype[log['question_id']]].append(1 if log['autoeval_label']['label'] else 0)
            
        for k,v in qtype2acc.items():
            print('\t{}: {} ({})'.format(k, round(np.mean(v), 4), len(v)))
