import { describe, it, expect } from 'vitest';
import { FastAPIPlugin } from '../../../src/indexer/plugins/integration/fastapi/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    rootPath: '/tmp/fastapi-project',
    configFiles: [],
    requirementsTxt: ['fastapi', 'uvicorn'],
    ...overrides,
  };
}

describe('FastAPIPlugin — detection', () => {
  it('detects via requirementsTxt', () => {
    const plugin = new FastAPIPlugin();
    expect(plugin.detect(makeCtx())).toBe(true);
  });

  it('rejects project without FastAPI', () => {
    const plugin = new FastAPIPlugin();
    expect(plugin.detect(makeCtx({ requirementsTxt: ['flask'] }))).toBe(false);
  });
});

describe('FastAPIPlugin — route extraction', () => {
  const code = `
from fastapi import FastAPI, Depends
from pydantic import BaseModel

app = FastAPI()

class UserCreate(BaseModel):
    name: str
    email: str

class UserResponse(BaseModel):
    id: int
    name: str

@app.get('/users', response_model=list[UserResponse])
async def list_users(db: Session = Depends(get_db)):
    return db.query(User).all()

@app.post('/users', response_model=UserResponse, status_code=201)
async def create_user(user_data: UserCreate, db: Session = Depends(get_db)):
    pass

@app.get('/users/{user_id}')
async def get_user(user_id: int):
    pass
`;

  it('extracts routes', () => {
    const plugin = new FastAPIPlugin();
    const result = plugin.extractNodes!('main.py', Buffer.from(code), 'python');
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    expect(data.routes).toBeDefined();
    expect(data.routes!.length).toBeGreaterThanOrEqual(3);

    const getUsers = data.routes!.find((r) => r.uri === '/users' && r.method === 'GET');
    expect(getUsers).toBeDefined();

    const postUsers = data.routes!.find((r) => r.uri === '/users' && r.method === 'POST');
    expect(postUsers).toBeDefined();

    const getUserById = data.routes!.find((r) => r.uri?.includes('{user_id}'));
    expect(getUserById).toBeDefined();
  });

  it('extracts Depends() edges', () => {
    const plugin = new FastAPIPlugin();
    const result = plugin.extractNodes!('main.py', Buffer.from(code), 'python');
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    const depEdges = data.edges?.filter((e) => e.edgeType === 'fastapi_depends') ?? [];
    expect(depEdges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FastAPIPlugin — router mount', () => {
  const code = `
from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter()

@router.get('/orders')
async def list_orders():
    pass

app.include_router(router, prefix='/api/v1')
`;

  it('extracts router mount edge', () => {
    const plugin = new FastAPIPlugin();
    const result = plugin.extractNodes!('main.py', Buffer.from(code), 'python');
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    const mountEdge = data.edges?.find((e) => e.edgeType === 'fastapi_router_mounts');
    expect(mountEdge).toBeDefined();
  });
});
