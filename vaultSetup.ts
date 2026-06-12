import * as pulumi from "@pulumi/pulumi";

const vaultInitProvider: pulumi.dynamic.ResourceProvider = {

    async diff(_id, _olds, _news) {
        return { changes: false };
    },

    async create(inputs: { vaultUrl: string }) {
        const { vaultUrl } = inputs;

        const maxAttempts = 60;
        const delayMs = 5000;
        let initialized: boolean | undefined;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const res = await fetch(`${vaultUrl}/v1/sys/init`);
                if (res.status === 200) {
                    const body = await res.json() as { initialized: boolean };
                    initialized = body.initialized;
                    break;
                }
            } catch (_e) { /* not yet reachable */ }
            await new Promise((r) => setTimeout(r, delayMs));
        }

        if (initialized === undefined) {
            throw new Error(`Vault at ${vaultUrl} did not become reachable after ${(maxAttempts * delayMs) / 1000}s`);
        }

        if (initialized) {
            throw new Error(
                "Vault is already initialized but no root token is in Pulumi state. " +
                "If you have the root token, import this resource manually."
            );
        }

        const initRes = await fetch(`${vaultUrl}/v1/sys/init`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recovery_shares: 1, recovery_threshold: 1 }),
        });
        if (!initRes.ok) throw new Error(`POST /v1/sys/init: ${initRes.status} ${await initRes.text()}`);

        const { root_token } = await initRes.json() as { root_token: string };
        return { id: "vault-init", outs: { vaultUrl, rootToken: root_token } };
    },

    async read(id: string, props: { vaultUrl?: string; rootToken?: string }) {
        if (props?.vaultUrl) {
            try {
                const res = await fetch(`${props.vaultUrl}/v1/sys/init`);
                if (res.ok) {
                    const { initialized } = await res.json() as { initialized: boolean };
                    if (!initialized) {
                        throw new Error("Vault is NOT initialized — storage may have been wiped. Taint this resource and re-run pulumi up.");
                    }
                }
            } catch (e: any) {
                if (e.message?.includes("NOT initialized")) throw e;
                // Network errors during refresh should not destroy state
            }
        }
        return { id, props };
    },

    async delete(_id: string, _props: object) {
        // Vault initialization cannot be reversed.
    },
};

export interface VaultInitArgs {
    vaultUrl: pulumi.Input<string>;
}

export class VaultInit extends pulumi.dynamic.Resource {
    public readonly rootToken!: pulumi.Output<string>;

    constructor(name: string, args: VaultInitArgs, opts?: pulumi.CustomResourceOptions) {
        super(
            vaultInitProvider,
            name,
            { rootToken: undefined, ...args },
            { ...opts, additionalSecretOutputs: ["rootToken"] },
        );
    }
}
