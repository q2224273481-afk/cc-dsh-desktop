declare module "js-yaml" {
  export interface Schema {
    extend(type: Type): Schema;
  }
  export class Type {
    constructor(
      tag: string,
      options: {
        kind: string;
        resolve?: (data: any) => boolean;
        construct?: (data: any) => any;
      },
    );
  }
  export const JSON_SCHEMA: Schema;
  export function load(content: string, options?: { schema?: Schema }): unknown;
}
