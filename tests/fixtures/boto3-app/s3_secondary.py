import boto3


def write_secondary(content):
    client = boto3.client('s3')
    client.put_object(Bucket='secondary-bucket', Key='secondary.json', Body=content)
