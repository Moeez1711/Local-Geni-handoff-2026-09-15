import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const publications = sqliteTable('publications', {
  id: text('id').primaryKey(), title: text('title').notNull(), objectKey: text('object_key').notNull(),
  publishedAt: integer('published_at').notNull(), revokedAt: integer('revoked_at'),
});
export const optouts = sqliteTable('unsubscribe_events', {
  sequence: integer('sequence').primaryKey({autoIncrement:true}), tokenId: text('token_id').notNull().unique(), occurredAt: integer('occurred_at').notNull(),
});
