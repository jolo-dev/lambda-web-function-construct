export const SESSION_PASSWORD_ENV = "FULLSTACK_SESSION_PASSWORD";

export function readSessionPassword(value: string | undefined): string {
	if (!value || value.length < 32) {
		throw new Error(`sessionPassword (or ${SESSION_PASSWORD_ENV}) must be at least 32 characters`);
	}
	return value;
}
