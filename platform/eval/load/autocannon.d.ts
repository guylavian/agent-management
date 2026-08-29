declare module "autocannon" {
  interface Options {
    url: string;
    connections: number;
    duration: number;
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
  interface Result {
    requests: Record<string, number>;
    latency: Record<string, number>;
    errors: number;
    timeouts: number;
  }
  export default function autocannon(options: Options): Promise<Result>;
}
