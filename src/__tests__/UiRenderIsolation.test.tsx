import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { subscribeTick, useSharedTick } from '../hooks/useSharedTicker';
import { ConnectedHeaderBar } from '../components/common/ConnectedHeaderBar';
import { AppNavigator } from '../navigation/AppNavigator';
import { useRadarStore } from '../store/useRadarStore';

let mockSignalsRenders = 0;
jest.mock('../components/common/FirstRunOnboarding', () => ({ FirstRunOnboarding: () => null }));
jest.mock('../screens/SignalsScreen', () => ({
  SignalsScreen: () => {
    mockSignalsRenders++;
    return null;
  },
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockSignalsRenders = 0;
  useRadarStore.setState({ istTime: '09:15:00 IST', marketStatus: 'REGULAR_HOURS', signalsTodayCount: 0 });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('shared ticker', () => {
  test('all subscribers of one period share a single interval, cleared with the last one', () => {
    const setSpy = jest.spyOn(global, 'setInterval');
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const a = jest.fn();
    const b = jest.fn();

    const offA = subscribeTick(300, a);
    const offB = subscribeTick(300, b);
    expect(setSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(900);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(3);

    offA();
    expect(clearSpy).not.toHaveBeenCalled();
    offB();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(900);
    expect(a).toHaveBeenCalledTimes(3);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  test('useSharedTick re-renders only while enabled', () => {
    let renders = 0;
    function Probe({ on }: { on: boolean }) {
      renders++;
      useSharedTick(on, 300);
      return null;
    }

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Probe on={true} />);
    });
    const afterMount = renders;
    act(() => {
      jest.advanceTimersByTime(300);
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(renders).toBe(afterMount + 2);

    act(() => {
      tree.update(<Probe on={false} />);
    });
    const afterDisable = renders;
    act(() => {
      jest.advanceTimersByTime(900);
    });
    expect(renders).toBe(afterDisable);
    act(() => tree.unmount());
  });
});

describe('clock isolation', () => {
  test('ConnectedHeaderBar follows the store clock', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<ConnectedHeaderBar />);
    });
    const clock = () =>
      tree.root
        .findAllByType(Text)
        .map((t) => String(t.props.children))
        .find((s) => s.includes('IST'));

    expect(clock()).toBe('09:15:00 IST');
    act(() => useRadarStore.getState().setIstTime('09:15:01 IST'));
    expect(clock()).toBe('09:15:01 IST');
    act(() => tree.unmount());
  });

  test('the navigator and its tab content do not re-render on clock ticks', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<AppNavigator />);
    });
    const baseline = mockSignalsRenders;
    expect(baseline).toBeGreaterThan(0);

    act(() => useRadarStore.getState().setIstTime('09:15:01 IST'));
    act(() => useRadarStore.getState().setIstTime('09:15:02 IST'));
    expect(mockSignalsRenders).toBe(baseline);

    act(() => useRadarStore.setState({ signalsTodayCount: 3 }));
    expect(mockSignalsRenders).toBeGreaterThan(baseline);
    act(() => tree.unmount());
  });

  test('setIstTime ignores an unchanged value', () => {
    const listener = jest.fn();
    const off = useRadarStore.subscribe(listener);
    useRadarStore.getState().setIstTime('09:15:00 IST');
    expect(listener).not.toHaveBeenCalled();
    useRadarStore.getState().setIstTime('09:15:01 IST');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
