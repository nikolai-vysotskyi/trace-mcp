// @ts-nocheck
import { Upload } from '@aws-sdk/lib-storage';
import { s3 } from './client';

export function streamToBackups(key: string, body: NodeJS.ReadableStream) {
  return new Upload({
    client: s3,
    params: {
      Bucket: 'backups',
      Key: key,
      Body: body,
    },
  });
}
