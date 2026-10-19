import { strategyRegistry } from './StrategyRegistry';
import { VolumeCrossoverPlugin } from './plugins/VolumeCrossoverPlugin';
import { NiftyOvernightPlugin } from './plugins/NiftyOvernightPlugin';
import { NiftyBreakout180Plugin } from './plugins/NiftyBreakout180Plugin';
import { Orb15MinPlugin } from './plugins/Orb15MinPlugin';
// Register all active quantitative strategies
strategyRegistry.register(VolumeCrossoverPlugin);
strategyRegistry.register(NiftyOvernightPlugin);
strategyRegistry.register(NiftyBreakout180Plugin);
strategyRegistry.register(Orb15MinPlugin);

export { strategyRegistry };
