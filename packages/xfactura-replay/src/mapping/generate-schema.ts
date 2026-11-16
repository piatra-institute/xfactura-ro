import { mappingJsonSchema } from './schema';

if (import.meta.main)
  await Bun.write(
    new URL('./mapping.schema.json', import.meta.url),
    `${JSON.stringify(mappingJsonSchema, null, 2)}\n`,
  );
