"use server";

export interface SquareState {
  readonly message: string;
}

const MAXIMUM_INPUT = 1000;

/** Validates the submitted value on the server before computing its square. Stateless: nothing is stored. */
export async function squareAction(_previous: SquareState, formData: FormData): Promise<SquareState> {
  const raw = formData.get("value");
  const text = typeof raw === "string" ? raw.trim() : "";
  const value = /^\d{1,4}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value > MAXIMUM_INPUT) {
    return { message: `Enter a whole number from 0 to ${MAXIMUM_INPUT}` };
  }
  return { message: `${value} squared is ${value * value}` };
}
