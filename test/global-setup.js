import { MongoMemoryServer } from 'mongodb-memory-server';

/** One real mongod for the whole run; each test file uses its own database. */
export default async function setup(project) {
  const server = await MongoMemoryServer.create();
  project.provide('mongoUri', server.getUri());
  return async () => {
    await server.stop();
  };
}
