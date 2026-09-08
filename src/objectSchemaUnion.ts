import * as z from "zod/v4";

/** MCP output validation requires an object schema. Preserve a closed union's
 * exact runtime branches and publish an object-rooted JSON Schema instead of
 * weakening the variants into an optional-field router. */
export function objectSchemaUnion<const Schemas extends readonly [z.ZodType, ...z.ZodType[]]>(schemas: Schemas, published: z.ZodType = z.union(schemas)): z.ZodType<z.output<Schemas[number]>> {
  const union = z.union(schemas);
  const checked = z.looseObject({}).superRefine((value, context) => {
    const result = union.safeParse(value);
    if (!result.success) context.addIssue({ code: "custom", message: result.error.message });
    else Object.assign(value, result.data);
  });
  // Clone the definition without a parent: otherwise Zod can either replace
  // the projection with the empty object's shape or try to resolve an unseen
  // parent reference. Checks remain in the cloned definition.
  const runtime = checked.clone(checked._zod.def, { parent: false });
  const projection = { ...z.toJSONSchema(published, { target: "draft-7", io: "input" }), type: "object" };
  (runtime._zod as typeof runtime._zod & { toJSONSchema: () => Record<string, unknown> }).toJSONSchema = () => structuredClone(projection);
  return runtime as unknown as z.ZodType<z.output<Schemas[number]>>;
}
