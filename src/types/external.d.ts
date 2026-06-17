// Ambient declarations for dependencies whose published types are missing or under-specify the surface we
// use (verified at runtime).

declare module "chrome-remote-interface" {
  const CDP: (opts?: any) => Promise<any>;
  export default CDP;
}
