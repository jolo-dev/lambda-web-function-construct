import { z } from "zod";

const authTypeSchema = z.enum(["IamAuth", "ApplicationManaged"]);
const endpointTypeSchema = z.enum(["HomeRegion", "MultiRegion", "PerRegion"]);

/** Authentication mode for a Lambda Web Function endpoint. */
export class WebFunctionAuthType {
	/** Authenticate requests using AWS IAM. */
	public static readonly IAM_AUTH = new WebFunctionAuthType(
		authTypeSchema.enum.IamAuth,
	);

	/** Let the application authenticate requests. */
	public static readonly APPLICATION_MANAGED = new WebFunctionAuthType(
		authTypeSchema.enum.ApplicationManaged,
	);

	private readonly authType: string;

	/** The value sent to CloudFormation. */
	public get value(): string {
		return this.authType;
	}

	private constructor(value: string) {
		this.authType = authTypeSchema.parse(value);
	}
}

/** Region behavior for a Lambda Web Function endpoint. */
export class WebFunctionEndpointType {
	/** Serve the endpoint in the function's home Region. */
	public static readonly HOME_REGION = new WebFunctionEndpointType(
		endpointTypeSchema.enum.HomeRegion,
	);

	/** Serve the endpoint in multiple Regions. */
	public static readonly MULTI_REGION = new WebFunctionEndpointType(
		endpointTypeSchema.enum.MultiRegion,
	);

	/** Create a separate endpoint for each Region. */
	public static readonly PER_REGION = new WebFunctionEndpointType(
		endpointTypeSchema.enum.PerRegion,
	);

	private readonly endpointType: string;

	/** The value sent to CloudFormation. */
	public get value(): string {
		return this.endpointType;
	}

	private constructor(value: string) {
		this.endpointType = endpointTypeSchema.parse(value);
	}
}
