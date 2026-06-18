import { validateSync, type ValidationError } from "class-validator";

/**
 * validateStrict — run class-validator over `obj` under the one strict regime this codebase uses everywhere
 * (`whitelist` + `forbidNonWhitelisted`: reject any property the class doesn't declare), and flatten the
 * nested ValidationError tree into `"field[.child]: message"` lines. Returns `[]` when valid.
 *
 * Single home for the rule the output envelope (`Trace`) and the CLI input DTOs (`CommandInputs`) share — the
 * recursion into `children` surfaces failures inside nested entities (events[], lineage[].series[],
 * data.recording, …) with a dotted path.
 */
export function validateStrict(target: object): string[] {
  const flatten = (errors: ValidationError[], path = ""): string[] =>
    errors.flatMap((error) => {
      const fieldPath = path ? `${path}.${error.property}` : error.property;
      const messages = Object.values(error.constraints ?? {}).map((message) => `${fieldPath}: ${message}`);
      return error.children?.length ? messages.concat(flatten(error.children, fieldPath)) : messages;
    });
  return flatten(validateSync(target, { whitelist: true, forbidNonWhitelisted: true }));
}
