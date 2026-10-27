import {
	WebFunctionAuthType,
	WebFunctionEndpointType,
	type WebFunctionProps,
} from "../../src";

const valid: WebFunctionProps = {
	entry: "http.ts",
	functionName: "typecheck",
	endpointName: "prod",
	authType: WebFunctionAuthType.APPLICATION_MANAGED,
	endpointType: WebFunctionEndpointType.HOME_REGION,
};

const invalidString: WebFunctionProps = {
	...valid,
	// @ts-expect-error Plain strings must not bypass the typed options.
	authType: "ApplicationManaged",
};

const invalidAuthType: WebFunctionProps = {
	...valid,
	// @ts-expect-error Endpoint options must not be accepted as authentication modes.
	authType: WebFunctionEndpointType.HOME_REGION,
};

const invalidEndpointType: WebFunctionProps = {
	...valid,
	// @ts-expect-error Authentication modes must not be accepted as endpoint options.
	endpointType: WebFunctionAuthType.IAM_AUTH,
};

// @ts-expect-error Consumers must use the named, validated constants.
new WebFunctionAuthType("IamAuth");

void [valid, invalidString, invalidAuthType, invalidEndpointType];
