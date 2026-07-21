/**
 * `turndown-plugin-gfm` ships no types and has no `@types` package. Only the
 * export we actually use is declared.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  /** Adds the GFM table rules. Cell content still needs `tableCellParagraph`. */
  export const tables: TurndownService.Plugin;
}
