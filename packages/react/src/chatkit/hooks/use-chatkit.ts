import { useTildeClient } from "../../provider";

export function useChatKit() {
  return useTildeClient().chatkit;
}
