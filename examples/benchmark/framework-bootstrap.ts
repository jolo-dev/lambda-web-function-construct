/** Standard AL2023 ships AWS CLI v2: https://docs.aws.amazon.com/linux/al2023/ug/awscli2.html */
export function deliveryCommands(bucket:string,region:string){
	if(!/^[a-z0-9.-]+$/.test(bucket)||!/^[a-z0-9-]+$/.test(region))throw Error("Invalid artifact bucket or region");
	return `#!/bin/bash
set -euo pipefail
command -v aws
aws --version
command -v tar
command -v gzip
mkdir -p /opt/framework-bench
aws s3 cp s3://${bucket}/input/package.tar.gz /opt/framework-bench/package.tar.gz --region ${region} --only-show-errors
tar -xzf /opt/framework-bench/package.tar.gz -C /opt/framework-bench
bash /opt/framework-bench/bootstrap.sh`;
}
