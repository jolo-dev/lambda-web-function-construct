"use client";

import { useActionState } from "react";
import { type SquareState, squareAction } from "./actions";

const initialState: SquareState = { message: "" };

export function SquareForm() {
  const [state, formAction] = useActionState(squareAction, initialState);
  return (
    <form action={formAction}>
      <label>
        Number <input name="value" inputMode="numeric" />
      </label>{" "}
      <button type="submit">Square it</button>
      {state.message !== "" && <p role="status">{state.message}</p>}
    </form>
  );
}
