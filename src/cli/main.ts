import "reflect-metadata"; // MUST be first — class-transformer/@Type metadata depends on it
import { Cli } from "./Cli.js";

new Cli().run();
