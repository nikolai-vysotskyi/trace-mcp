import { describe, expect, it } from 'vitest';
import { DjangoPlugin } from '../../../src/indexer/plugins/integration/framework/django/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    rootPath: '/tmp/django-project',
    configFiles: ['manage.py'],
    ...overrides,
  };
}

describe('DjangoPlugin — detection', () => {
  it('detects via manage.py in configFiles', () => {
    const plugin = new DjangoPlugin();
    expect(plugin.detect(makeCtx())).toBe(true);
  });

  it('rejects project without Django markers', () => {
    const plugin = new DjangoPlugin();
    expect(plugin.detect(makeCtx({ configFiles: [] }))).toBe(false);
  });
});

describe('DjangoPlugin — registerSchema', () => {
  it('returns Django edge types', () => {
    const plugin = new DjangoPlugin();
    const schema = plugin.registerSchema();
    const edgeNames = schema.edgeTypes?.map((e) => e.name) ?? [];
    expect(edgeNames).toContain('django_url_routes_to');
    expect(edgeNames).toContain('django_view_uses_model');
    expect(edgeNames).toContain('django_signal_receiver');
    expect(edgeNames).toContain('django_admin_registers');
    expect(edgeNames).toContain('django_form_meta_model');
  });
});

describe('DjangoPlugin — model extraction', () => {
  const modelCode = `
from django.db import models

class User(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField(unique=True)
    role = models.ForeignKey('Role', on_delete=models.CASCADE, related_name='users')
    tags = models.ManyToManyField('Tag', blank=True)

    class Meta:
        db_table = 'users'
        ordering = ['-created_at']

class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    bio = models.TextField(blank=True)
`;

  it('extracts models with fields and associations', async () => {
    const plugin = new DjangoPlugin();
    const result = await plugin.extractNodes!('myapp/models.py', Buffer.from(modelCode), 'python');
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    // Should find orm models
    expect(data.ormModels).toBeDefined();
    expect(data.ormModels!.length).toBeGreaterThanOrEqual(2);

    const user = data.ormModels!.find((m) => m.name === 'User');
    expect(user).toBeDefined();
    expect(user!.collectionOrTable).toBe('users');

    // Should find associations
    expect(data.ormAssociations).toBeDefined();
    const fk = data.ormAssociations!.find(
      (a) => a.sourceModelName === 'User' && a.targetModelName === 'Role',
    );
    expect(fk).toBeDefined();
    expect(fk!.kind).toBe('foreign_key');

    const m2m = data.ormAssociations!.find(
      (a) => a.sourceModelName === 'User' && a.targetModelName === 'Tag',
    );
    expect(m2m).toBeDefined();
    expect(m2m!.kind).toBe('many_to_many');
  });
});

describe('DjangoPlugin — URL extraction', () => {
  const urlCode = `
from django.urls import path, include
from . import views

urlpatterns = [
    path('users/', views.UserListView.as_view(), name='user-list'),
    path('users/<int:pk>/', views.UserDetailView.as_view(), name='user-detail'),
    path('api/', include('myapp.api.urls')),
]
`;

  it('extracts URL routes', async () => {
    const plugin = new DjangoPlugin();
    const result = await plugin.extractNodes!('myapp/urls.py', Buffer.from(urlCode), 'python');
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    expect(data.routes).toBeDefined();
    expect(data.routes!.length).toBeGreaterThanOrEqual(2);

    const userList = data.routes!.find((r) => r.name === 'user-list');
    expect(userList).toBeDefined();
    expect(userList!.uri).toContain('users');
  });

  it('extracts include() as edges', async () => {
    const plugin = new DjangoPlugin();
    const result = await plugin.extractNodes!('myapp/urls.py', Buffer.from(urlCode), 'python');
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    const includeEdge = data.edges?.find((e) => e.edgeType === 'django_includes_urls');
    expect(includeEdge).toBeDefined();
  });
});

describe('DjangoPlugin — signal extraction', () => {
  const signalCode = `
from django.db.models.signals import post_save
from django.dispatch import receiver

@receiver(post_save, sender=User)
def send_welcome_email(sender, instance, created, **kwargs):
    if created:
        send_email(instance.email)
`;

  it('extracts signal receiver edges', async () => {
    const plugin = new DjangoPlugin();
    const result = await plugin.extractNodes!(
      'myapp/signals.py',
      Buffer.from(signalCode),
      'python',
    );
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    const signalEdge = data.edges?.find((e) => e.edgeType === 'django_signal_receiver');
    expect(signalEdge).toBeDefined();
  });
});

describe('DjangoPlugin — admin extraction', () => {
  const adminCode = `
from django.contrib import admin
from .models import User, Post

@admin.register(User)
class UserAdmin(admin.ModelAdmin):
    list_display = ['name', 'email']

admin.site.register(Post)
`;

  it('extracts admin registrations', async () => {
    const plugin = new DjangoPlugin();
    const result = await plugin.extractNodes!('myapp/admin.py', Buffer.from(adminCode), 'python');
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    const adminEdges = data.edges?.filter((e) => e.edgeType === 'django_admin_registers') ?? [];
    expect(adminEdges.length).toBeGreaterThanOrEqual(1);
  });
});
