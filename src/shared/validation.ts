import { validateSync, type ValidationError } from "class-validator";

/**
 * validateStrict — run class-validator over `obj` under the one strict regime this codebase uses everywhere
 * (`whitelist` + `forbidNonWhitelisted`: reject any property the class doesn't declare), and flatten the
 * nested ValidationError tree into `"field[.child]: message"` lines. Returns `[]` when valid.
 *
 * Single home for the rule the output envelope (`Trace`), the journey result (`JourneyResult`) and the CLI
 * input DTOs (`CommandInputs`) all share — the recursion into `children` surfaces failures inside nested
 * entities (events[], lineage[].series[], data.recording, …) with a dotted path.
 */
export function validateStrict(obj: object): string[] {
  const flatten = (errs: ValidationError[], path = ""): string[] =>
    errs.flatMap((e) => {
      const at = path ? `${path}.${e.property}` : e.property;
      const here = Object.values(e.constraints ?? {}).map((m) => `${at}: ${m}`);
      return e.children?.length ? here.concat(flatten(e.children, at)) : here;
    });
  return flatten(validateSync(obj, { whitelist: true, forbidNonWhitelisted: true }));
}
