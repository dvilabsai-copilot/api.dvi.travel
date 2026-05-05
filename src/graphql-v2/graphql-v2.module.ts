import { Module } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { DashboardModule } from '../modules/dashboard/dashboard.module';
import { DashboardV2Resolver } from './resolvers/dashboard-v2.resolver';

@Module({
  imports: [
    DashboardModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      path: '/api/v2/graphql',
      autoSchemaFile: join(process.cwd(), 'src/schema-v2.gql'),
      sortSchema: true,
      playground: process.env.NODE_ENV !== 'production',
      context: ({ req, res }) => ({ req, res }),
    }),
  ],
  providers: [DashboardV2Resolver],
})
export class GraphqlV2Module {}
