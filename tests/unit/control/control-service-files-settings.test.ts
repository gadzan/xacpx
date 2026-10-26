import { test, expect } from "bun:test";
import {
  ControlService,
  type ControlServiceDeps,
} from "../../../src/control/control-service";

function service(deps: Partial<ControlServiceDeps>): ControlService {
  return new ControlService({
    events: { subscribe: () => () => {}, emit: () => {} },
    ...deps,
  } as unknown as ControlServiceDeps);
}

test("files settings are unavailable in an embedding that does not wire them", async () => {
  const svc = service({});
  await expect(svc.getFilesSettings()).rejects.toMatchObject({ code: "files_settings_unavailable" });
  await expect(svc.updateFilesSettings(true)).rejects.toMatchObject({ code: "files_settings_unavailable" });
});

test("the write switch is hot-applied, so it never reports restartRequired", async () => {
  const seen: boolean[] = [];
  const svc = service({
    filesSettings: {
      get: async () => ({ enabled: false, restartRequired: false as const }),
      update: async (enabled: boolean) => {
        seen.push(enabled);
        return { enabled, restartRequired: false as const };
      },
    },
  });

  expect(await svc.getFilesSettings()).toEqual({ enabled: false, restartRequired: false });
  expect(await svc.updateFilesSettings(true)).toEqual({ enabled: true, restartRequired: false });
  expect(await svc.updateFilesSettings(false)).toEqual({ enabled: false, restartRequired: false });
  expect(seen).toEqual([true, false]);
});
