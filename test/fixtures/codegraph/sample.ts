import { helperFn } from "./helper.js";

// entry → alpha, beta, helperFn(cross-file);  alpha → gamma;  beta → gamma, alpha(shared);
// gamma → recur;  recur → recur (self-cycle).  Exercises cross-file resolution, shared callees, recursion.
export function entry(): number {
  return alpha() + beta() + helperFn();
}

function alpha(): number {
  return gamma();
}

function beta(): number {
  return gamma() + alpha();
}

function gamma(): number {
  return recur(3);
}

function recur(n: number): number {
  return n <= 0 ? 0 : recur(n - 1);
}
