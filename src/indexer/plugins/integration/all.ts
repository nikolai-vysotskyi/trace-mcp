import type { FrameworkPlugin } from '../../../plugin-api/types.js';
import { LaravelPlugin } from './laravel/index.js';
import { VueFrameworkPlugin } from './vue/index.js';
import { InertiaPlugin } from './inertia/index.js';
import { NuxtPlugin } from './nuxt/index.js';
import { BladePlugin } from './blade/index.js';
import { NestJSPlugin } from './nestjs/index.js';
import { NextJSPlugin } from './nextjs/index.js';
import { ExpressPlugin } from './express/index.js';
import { MongoosePlugin } from './mongoose/index.js';
import { SequelizePlugin } from './sequelize/index.js';
import { ReactNativePlugin } from './react-native/index.js';
import { PrismaPlugin } from './prisma/index.js';
import { GraphQLPlugin } from './graphql/index.js';
import { TypeORMPlugin } from './typeorm/index.js';
import { DrizzlePlugin } from './drizzle/index.js';
import { DRFPlugin } from './drf/index.js';
import { PydanticPlugin } from './pydantic/index.js';
import { CeleryPlugin } from './celery/index.js';
import { FastAPIPlugin } from './fastapi/index.js';
import { FlaskPlugin } from './flask/index.js';
import { SQLAlchemyPlugin } from './sqlalchemy/index.js';
import { SpringPlugin } from './spring/index.js';
import { RailsPlugin } from './rails/index.js';
import { DjangoPlugin } from './django/index.js';
import { ReactPlugin } from './react/index.js';
import { TrpcPlugin } from './trpc/index.js';
import { FastifyPlugin } from './fastify/index.js';
import { HonoPlugin } from './hono/index.js';
import { SocketIoPlugin } from './socketio/index.js';
import { ZustandReduxPlugin } from './zustand/index.js';
import { N8nPlugin } from './n8n/index.js';
import { DataFetchingPlugin } from './data-fetching/index.js';
import { ZodPlugin } from './zod/index.js';
import { TestingPlugin } from './testing/index.js';
import { ShadcnPlugin } from './shadcn/index.js';
import { MuiPlugin } from './mui/index.js';
import { AntDesignPlugin } from './antd/index.js';
import { HeadlessUiPlugin } from './headless-ui/index.js';

export function createAllIntegrationPlugins(): FrameworkPlugin[] {
  return [
    new LaravelPlugin(),
    new VueFrameworkPlugin(),
    new InertiaPlugin(),
    new NuxtPlugin(),
    new BladePlugin(),
    new NestJSPlugin(),
    new NextJSPlugin(),
    new ExpressPlugin(),
    new MongoosePlugin(),
    new SequelizePlugin(),
    new ReactNativePlugin(),
    new PrismaPlugin(),
    new GraphQLPlugin(),
    new TypeORMPlugin(),
    new DrizzlePlugin(),
    new DRFPlugin(),
    new PydanticPlugin(),
    new CeleryPlugin(),
    new FastAPIPlugin(),
    new FlaskPlugin(),
    new SQLAlchemyPlugin(),
    new DjangoPlugin(),
    new TrpcPlugin(),
    new FastifyPlugin(),
    new SocketIoPlugin(),
    new HonoPlugin(),
    new ZustandReduxPlugin(),
    new ReactPlugin(),
    new N8nPlugin(),
    new SpringPlugin(),
    new RailsPlugin(),
    new DataFetchingPlugin(),
    new ZodPlugin(),
    new TestingPlugin(),
    new ShadcnPlugin(),
    new MuiPlugin(),
    new AntDesignPlugin(),
    new HeadlessUiPlugin(),
  ];
}
