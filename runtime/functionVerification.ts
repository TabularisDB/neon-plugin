import type {NeonFunction} from '@neon/sdk';

export function verificationInputError(deploymentId: unknown, marker: unknown): string | undefined {
    if (
        typeof deploymentId !== 'string' ||
        !/^[1-9][0-9]*$/.test(deploymentId) ||
        !Number.isSafeInteger(Number(deploymentId))
    )
        return 'Choose a deployment ID to verify';
    if (
        typeof marker !== 'string' ||
        !marker.trim() ||
        marker.includes('\0') ||
        Buffer.byteLength(marker) > 1024
    )
        return 'Provide a non-secret expected response marker of at most 1 KiB';
    return undefined;
}

/** Provider metadata is a prerequisite, never evidence of the code answering requests. */
export function deploymentVerificationState(
    value: NeonFunction,
    expectedDeploymentId: string,
): 'superseded' | 'inactive' | undefined {
    if (String(value.current_deployment?.id) !== expectedDeploymentId) return 'superseded';
    if (
        value.current_deployment?.status !== 'completed' ||
        String(value.active_deployment?.id) !== expectedDeploymentId ||
        value.active_deployment?.status !== 'completed'
    )
        return 'inactive';
    return undefined;
}
