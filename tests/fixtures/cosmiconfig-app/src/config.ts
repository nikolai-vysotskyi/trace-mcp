// @ts-nocheck
import { cosmiconfig } from 'cosmiconfig';
import dotenv from 'dotenv';

dotenv.config();

const explorer = cosmiconfig('myapp');

export async function loadConfig() {
  const result = await explorer.search();
  if (result && !result.isEmpty) {
    return result.config;
  }
  return {};
}

export async function loadConfigFrom(path: string) {
  const result = await explorer.load(path);
  return result?.config;
}
