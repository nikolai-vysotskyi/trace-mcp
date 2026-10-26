import os
import boto3

s3_client = boto3.client('s3', region_name=os.getenv('AWS_REGION'))
s3_res = boto3.resource('s3')
backup_bucket = s3_res.Bucket('backup-bucket')

def read_data():
    return s3_client.get_object(Bucket='analytics-bucket', Key='data/daily.json')

def write_data(content):
    s3_client.put_object(Bucket='analytics-bucket', Key='data/daily.json', Body=content)

def delete_data():
    s3_client.delete_object(Bucket='analytics-bucket', Key='data/daily.json')

def list_files():
    return s3_client.list_objects_v2(Bucket='analytics-bucket', Prefix='data/')

def sync_backup():
    backup_bucket.upload_file('/tmp/archive.tar.gz', 'backup/archive.tar.gz')
