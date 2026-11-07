/** A timed-out CLI can already have acknowledged a remote write. Never lose that job ID. */
export function executeAwsJson(invoke:()=>string,operation:string,expectedInstanceId?:string):any {
	try {const raw=invoke();return raw.trim()?JSON.parse(raw):{};}
	catch(error:any){
		if(error.code!=="ETIMEDOUT"||operation!=="ssm:send-command"||!expectedInstanceId)throw error;
		let response:any;
		try{response=JSON.parse(String(error.stdout??""));}catch{throw error;}
		const command=response.Command;
		if(!/^[0-9a-f-]{36}$/.test(command?.CommandId??"")||command.InstanceIds?.length!==1||command.InstanceIds[0]!==expectedInstanceId)throw error;
		console.warn("Recovered an AWS-acknowledged SSM command after local CLI timeout; retaining its command ID");
		return response;
	}
}
