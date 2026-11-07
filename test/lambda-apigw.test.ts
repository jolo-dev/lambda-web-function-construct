import { expect, test } from "bun:test";
import { handler } from "../examples/lambda-apigw/index";

test("non-reserved healthz path invokes the same workload as ping", async () => {
	const response = await handler({ rawPath: "/healthz", requestContext: { http: { method: "GET" } } }, { awsRequestId: "test-request" });
	expect(response.statusCode).toBe(200);
	expect(JSON.parse(response.body)).toEqual({ ok: true, server: "lambda-apigw" });
	expect(response.headers["x-lambda-request-id"]).toBe("test-request");
});
