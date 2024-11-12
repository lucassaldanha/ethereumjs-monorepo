import { Common, Mainnet } from "@ethereumjs/common";
import { ETH, RLPx } from "@ethereumjs/devp2p";
import { hexToBytes } from "@ethereumjs/util";

const main = async () => {
  const common = new Common({ chain: Mainnet });
  const privateKey = hexToBytes(
    "0xed6df2d4b7e82d105538e4a1279925a16a84e772243e80a561e1b201f2e78220",
  );
  const rlpx = new RLPx(privateKey, {
    maxPeers: 25,
    capabilities: [ETH.eth65, ETH.eth64],
    common,
  });
  console.log(`RLPx is active - ${rlpx._isAlive()}`);
  rlpx.destroy();
};

void main();
