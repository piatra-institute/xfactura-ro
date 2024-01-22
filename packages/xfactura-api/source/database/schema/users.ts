import {
    sqliteTable,
    text,
    integer,
    uniqueIndex,
} from 'drizzle-orm/sqlite-core';



export const users = sqliteTable(
    'users',
    {
        id: text('id').notNull().primaryKey(),
        createdAt: text('created_at').notNull(),
        name: text('name').notNull(),
        email: text('email').notNull(),
        payments: text('payments').notNull(),
        intelligentActs: integer('intelligent_acts').notNull(),
    },
    (users) => ({
        emailIdx: uniqueIndex('emailIdx').on(users.email),
    }),
);
