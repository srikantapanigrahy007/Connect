/**
 * Indexes the models define but the database doesn't have. Duplicate protection (unique
 * emails, idempotent messages, one active call per person, notification deduplication, …)
 * depends on them, so production refuses to start while any are missing (see server.js and
 * `npm run db:indexes`).
 *
 * @param {import('mongoose').Model[]} models
 * @returns {Promise<{ collection: string, index: object }[]>}
 */
export async function findMissingIndexes(models) {
  const missing = [];
  for (const model of models) {
    const { toCreate } = await model.diffIndexes();
    for (const index of toCreate) {
      missing.push({ collection: model.collection.collectionName, index });
    }
  }
  return missing;
}
