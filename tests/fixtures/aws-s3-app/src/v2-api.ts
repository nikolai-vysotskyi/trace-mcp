// @ts-nocheck
import AWS from 'aws-sdk';

const client = new AWS.S3({ region: 'us-east-1' });

export function fetchReport(key: string) {
  return client.getObject({
    Bucket: 'reports',
    Key: key,
  }).promise();
}

export function storeReport(key: string, body: Buffer) {
  return client.putObject({
    Bucket: 'reports',
    Key: key,
    Body: body,
  }).promise();
}

export function purgeReport(key: string) {
  return client.deleteObject({
    Bucket: 'reports',
    Key: key,
  }).promise();
}
