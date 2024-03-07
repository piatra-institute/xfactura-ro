import {
    sqliteTable,
    text,
    uniqueIndex,
} from 'drizzle-orm/sqlite-core';



export const companyDetails = sqliteTable(
    'companyDetails',
    {
        id: text('id').notNull().primaryKey(),
        vatNumber: text('vat_number').notNull(),
        data: text('data').notNull(),
    },
    (companyDetails) => ({
        vatNumberIdx: uniqueIndex('vatNumberIdx').on(companyDetails.vatNumber),
    }),
);
