// @ts-nocheck
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { s3 } from './client';

export async function readAvatar(key: string) {
  return s3.send(new GetObjectCommand({
    Bucket: 'avatars',
    Key: key,
  }));
}

export async function writeAvatar(key: string, body: Buffer) {
  return s3.send(new PutObjectCommand({
    Bucket: 'avatars',
    Key: key,
    Body: body,
  }));
}

export async function removeAvatar(key: string) {
  return s3.send(new DeleteObjectCommand({
    Bucket: 'avatars',
    Key: key,
  }));
}

export async function listLogs() {
  return s3.send(new ListObjectsV2Command({
    Bucket: 'logs',
    Prefix: 'app/',
  }));
}
