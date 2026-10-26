import boto3

glue = boto3.client('glue')

def start_etl():
    return glue.start_job_run(JobName='etl-orders-sync')

def check_etl(run_id):
    return glue.get_job_run(JobName='etl-orders-sync', RunId=run_id)
