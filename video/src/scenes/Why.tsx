import React from 'react';
import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {ci, E, pop} from '../anim';
import {Callout} from '../components/Callout';
import {label, PanelColumn, Rise} from '../components/Panel';
import {Shot} from '../components/Shot';
import {Tag} from '../components/Tag';
import {CLIPS, FACTS} from '../footage';
import {POI} from '../poi';
import {C, LINE, nums, words} from '../tokens';
import {TAG} from './Real';

const LO = CLIPS.locked.ev as {lock: number; rules: number; rule5: number};
const LA = CLIPS.lab.ev as {dragStart: number; dragEnd: number};

export const LOCKED_FRAMES = 78;
export const KEYS_FRAMES = 100;
export const LAB_FRAMES = 112;
export const WHY_FRAMES = LOCKED_FRAMES + KEYS_FRAMES + LAB_FRAMES;

/** The app's own stamp ("You did it"), larger: a white box, the ink stroke, a five-degree tilt. */
const Stamp: React.FC<{at: number; children: React.ReactNode; x: number; y: number; size?: number}> = ({at, children, x, y, size = 150}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < at) return null;
  const t = pop(frame, at, fps);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translate(-50%, -50%) rotate(-5deg) scale(${(1.7 - 0.7 * t).toFixed(4)})`,
        opacity: ci(frame, [at, at + 3], [0, 1]),
        padding: `${size * 0.1}px ${size * 0.3}px ${size * 0.2}px`,
        background: C.white,
        border: `${LINE * 1.5}px solid ${C.ink}`,
        color: C.ink,
        whiteSpace: 'nowrap',
        ...words(size),
      }}
    >
      {children}
    </div>
  );
};

/** "No admin." over the chain bar of the real page: in on "Locked: no access keys". */
const Locked: React.FC = () => (
  <>
    <Shot
      clip={CLIPS.locked}
      time={[[0, LO.lock + 6]]}
      cam={[
        {f: 0, v: [640, 400, 1.5]},
        {f: 6, v: [640, 400, 1.5]},
        {f: 34, v: [POI.locked.x + 40, POI.locked.y - 40, 3]},
      ]}
    />
    <Stamp at={3} x={960} y={300}>
      No admin.
    </Stamp>
  </>
);

/** Rule 5 on the real Rules page beside what the chain answers for the contract account. */
const Keys: React.FC = () => (
  <>
    <Shot
      clip={CLIPS.locked}
      time={[[0, LO.rule5 + 10]]}
      cam={[
        {f: 0, v: [POI.rule5.x, POI.rule5.y - 40, 1.9]},
        {f: 60, v: [POI.rule5.x, POI.rule5.y - 20, 1.96], e: E.linear},
      ]}
      win={[{f: 0, v: [0, 0, 1180, 1080]}]}
    >
      {({s, frame}) => {
        // Underline what the page itself reports: "Checked just now: this contract account has no access keys."
        const a = s({x: 112, y: 393});
        const b = s({x: 571, y: 393});
        const t = ci(frame, [20, 40], [0, 1], E.inOut);
        return (
          <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
            <line x1={a.x} y1={a.y} x2={a.x + (b.x - a.x) * t} y2={a.y} stroke={C.ink} strokeWidth={LINE} />
          </svg>
        );
      }}
    </Shot>
    <PanelColumn left={1250} width={600} gap={20}>
      <Rise at={6} style={{...nums(40, 600), color: C.white, letterSpacing: '0.01em'}}>
        view_access_key_list
      </Rise>
      <Rise at={9} style={{...nums(40, 600), color: C.white, letterSpacing: '0.01em'}}>
        {FACTS.contract}
      </Rise>
      <div style={{marginTop: 18}}>
        <Rise at={16} style={{...nums(158), color: C.accent, whiteSpace: 'nowrap'}}>
          {'"keys": []'}
        </Rise>
      </div>
      <div style={{marginTop: 22}}>
        <Rise at={30} style={label(58)}>
          No key, no owner,
        </Rise>
        <Rise at={33} style={label(58)}>
          no way to change
        </Rise>
        <Rise at={36} style={label(58)}>
          the rules.
        </Rise>
      </div>
    </PanelColumn>
  </>
);

/** The lab: the crowd-size slider dragged from 10 to 60 holders, fast, and the reading it lands on. */
const Lab: React.FC = () => {
  const T: [number, number][] = [
    [0, LA.dragStart - 14],
    [10, LA.dragStart - 4],
    [66, LA.dragEnd + 6],
  ];
  return (
    <>
      <Shot
        clip={CLIPS.lab}
        time={T}
        badgeTop={26}
        cam={[
          {f: 0, v: [640, 360, 1.5]},
          {f: 70, v: [640, 360, 1.5]},
          {f: 92, v: [700, 250, 1.9]},
        ]}
      >
        {({s}) => (
          <Callout at={s({x: 870, y: 322})} dx={-230} dy={-96} in={14} out={66} size={44}>
            simulated against the equilibrium
          </Callout>
        )}
      </Shot>
      <Tag left>lab · simulation in the browser</Tag>
    </>
  );
};

export const Why: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: C.ink}}>
      <Sequence name="No admin" durationInFrames={LOCKED_FRAMES}>
        <Locked />
        <Tag>{TAG}</Tag>
      </Sequence>
      <Sequence name="Keys" from={LOCKED_FRAMES} durationInFrames={KEYS_FRAMES}>
        <Keys />
        <Tag>{TAG}</Tag>
      </Sequence>
      <Sequence name="Lab" from={LOCKED_FRAMES + KEYS_FRAMES} durationInFrames={LAB_FRAMES}>
        <Lab />
      </Sequence>
    </AbsoluteFill>
  );
};
