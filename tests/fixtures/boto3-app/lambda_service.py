import boto3

lambda_client = boto3.client('lambda')

def invoke_worker(payload):
    return lambda_client.invoke(FunctionName='worker-dispatcher', Payload=payload)

def get_worker_info():
    return lambda_client.get_function(FunctionName='worker-dispatcher')
