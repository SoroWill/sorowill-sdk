import { DEFAULT_CONTRACT_IDS } from './SoroWillClient';
import type { SoroWillNetwork } from './SoroWillClient';

export type SoroWillConfigInput = {
  network?: SoroWillNetwork;
  contractId?: string;
  rpcUrl?: string;
};

export type SoroWillConfig = Required<SoroWillConfigInput>;

export const DEFAULT_NETWORK: SoroWillNetwork = 'testnet';

export function getDefaultContractId(network: SoroWillNetwork): string {
  return DEFAULT_CONTRACT_IDS[network];
}

export function resolveSoroWillConfig(input: SoroWillConfigInput = {}): SoroWillConfig {
  const network = input.network ?? DEFAULT_NETWORK;
  return {
    network,
    contractId: input.contractId ?? getDefaultContractId(network),
    rpcUrl: input.rpcUrl ?? `https://rpc-${network}.stellar.org`,
  };
}
