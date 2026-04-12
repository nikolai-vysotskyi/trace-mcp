import type { FrameworkPlugin } from '../../../plugin-api/types.js';

// --- framework ---
import { LaravelPlugin } from './framework/laravel/index.js';
import { DjangoPlugin } from './framework/django/index.js';
import { RailsPlugin } from './framework/rails/index.js';
import { SpringPlugin } from './framework/spring/index.js';
import { NestJSPlugin } from './framework/nestjs/index.js';
import { ExpressPlugin } from './framework/express/index.js';
import { FastAPIPlugin } from './framework/fastapi/index.js';
import { FlaskPlugin } from './framework/flask/index.js';
import { HonoPlugin } from './framework/hono/index.js';
import { FastifyPlugin } from './framework/fastify/index.js';
import { NuxtPlugin } from './framework/nuxt/index.js';
import { NextJSPlugin } from './framework/nextjs/index.js';
import { GinPlugin } from './framework/gin/index.js';
import { EchoPlugin } from './framework/echo/index.js';

// --- orm ---
import { PrismaPlugin } from './orm/prisma/index.js';
import { TypeORMPlugin } from './orm/typeorm/index.js';
import { SequelizePlugin } from './orm/sequelize/index.js';
import { MongoosePlugin } from './orm/mongoose/index.js';
import { SQLAlchemyPlugin } from './orm/sqlalchemy/index.js';
import { DrizzlePlugin } from './orm/drizzle/index.js';
import { RawSqlPlugin } from './orm/raw-sql/index.js';
import { AsyncDbPlugin } from './orm/async-db/index.js';

// --- view ---
import { ReactPlugin } from './view/react/index.js';
import { VueFrameworkPlugin } from './view/vue/index.js';
import { ReactNativePlugin } from './view/react-native/index.js';
import { BladePlugin } from './view/blade/index.js';
import { InertiaPlugin } from './view/inertia/index.js';
import { ShadcnPlugin } from './view/shadcn/index.js';
import { MuiPlugin } from './view/mui/index.js';
import { AntDesignPlugin } from './view/antd/index.js';
import { HeadlessUiPlugin } from './view/headless-ui/index.js';
import { NuxtUiPlugin } from './view/nuxt-ui/index.js';
import { AngularPlugin } from './view/angular/index.js';
import { SveltePlugin } from './view/svelte/index.js';
import { TailwindPlugin } from './view/tailwind/index.js';

// --- api ---
import { GraphQLPlugin } from './api/graphql/index.js';
import { TrpcPlugin } from './api/trpc/index.js';
import { DRFPlugin } from './api/drf/index.js';
import { McpSdkPlugin } from './api/mcp-sdk/index.js';

// --- validation ---
import { ZodPlugin } from './validation/zod/index.js';
import { PydanticPlugin } from './validation/pydantic/index.js';

// --- state ---
import { ZustandReduxPlugin } from './state/zustand/index.js';

// --- realtime ---
import { SocketIoPlugin } from './realtime/socketio/index.js';

// --- testing ---
import { TestingPlugin } from './testing/index.js';
import { PytestPlugin } from './testing/pytest/index.js';

// --- tooling ---
import { CeleryPlugin } from './tooling/celery/index.js';
import { N8nPlugin } from './tooling/n8n/index.js';
import { DataFetchingPlugin } from './tooling/data-fetching/index.js';
import { CommanderPlugin } from './tooling/commander/index.js';
import { TreeSitterPlugin } from './tooling/tree-sitter/index.js';
import { BuildToolsPlugin } from './tooling/build-tools/index.js';
import { GithubActionsPlugin } from './tooling/github-actions/index.js';
import { PinoPlugin } from './tooling/pino/index.js';
import { CosmiconfigPlugin } from './tooling/cosmiconfig/index.js';
import { NeverthrowPlugin } from './tooling/neverthrow/index.js';
import { ClackPlugin } from './tooling/clack/index.js';

export function createAllIntegrationPlugins(): FrameworkPlugin[] {
  return [
    // framework
    new LaravelPlugin(),
    new DjangoPlugin(),
    new RailsPlugin(),
    new SpringPlugin(),
    new NestJSPlugin(),
    new ExpressPlugin(),
    new FastAPIPlugin(),
    new FlaskPlugin(),
    new HonoPlugin(),
    new FastifyPlugin(),
    new NuxtPlugin(),
    new NextJSPlugin(),
    new GinPlugin(),
    new EchoPlugin(),
    // orm
    new PrismaPlugin(),
    new TypeORMPlugin(),
    new SequelizePlugin(),
    new MongoosePlugin(),
    new SQLAlchemyPlugin(),
    new DrizzlePlugin(),
    new RawSqlPlugin(),
    new AsyncDbPlugin(),
    // view
    new ReactPlugin(),
    new VueFrameworkPlugin(),
    new ReactNativePlugin(),
    new BladePlugin(),
    new InertiaPlugin(),
    new ShadcnPlugin(),
    new MuiPlugin(),
    new AntDesignPlugin(),
    new HeadlessUiPlugin(),
    new NuxtUiPlugin(),
    new AngularPlugin(),
    new SveltePlugin(),
    new TailwindPlugin(),
    // api
    new GraphQLPlugin(),
    new TrpcPlugin(),
    new DRFPlugin(),
    new McpSdkPlugin(),
    // validation
    new ZodPlugin(),
    new PydanticPlugin(),
    // state
    new ZustandReduxPlugin(),
    // realtime
    new SocketIoPlugin(),
    // testing
    new TestingPlugin(),
    new PytestPlugin(),
    // tooling
    new CeleryPlugin(),
    new N8nPlugin(),
    new DataFetchingPlugin(),
    new CommanderPlugin(),
    new TreeSitterPlugin(),
    new BuildToolsPlugin(),
    new GithubActionsPlugin(),
    new PinoPlugin(),
    new CosmiconfigPlugin(),
    new NeverthrowPlugin(),
    new ClackPlugin(),
  ];
}
