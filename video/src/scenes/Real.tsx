import React from 'react';
import {AbsoluteFill, Sequence, useCurrentFrame} from 'remotion';
import {ci, E} from '../anim';
import {Callout} from '../components/Callout';
import {Numeral} from '../components/Numeral';
import {Chip, label, PanelColumn, Rise} from '../components/Panel';
import {Shot} from '../components/Shot';
import {Tag} from '../components/Tag';
import {CLIPS, FACTS} from '../footage';
import {POI, STAGE} from '../poi';
import {stageCam} from '../stage';
import {C, nums, words} from '../tokens';

/** Windows on screen: the whole frame, and the plate beside the ink column. */
const FULLW = [0, 0, 1920, 1080];
const SPLITW = [0, 0, 1180, 1080];
const COL = 1250;
const WIDE = [640, 360, 1.5];

export const TAG = 'real session · NEAR testnet';

/* ------------------------------------------------------------------ A. watch */

export const WATCH_FRAMES = 84;
const Watch: React.FC = () => {
  const sc = stageCam();
  return (
    <Shot
      clip={CLIPS.watch}
      time={[[0, 0]]}
      cam={[
        {f: 0, v: [sc.x, sc.y, sc.z]},
        {f: 8, v: [sc.x, sc.y, sc.z]},
        {f: 34, v: WIDE},
      ]}
    >
      {({s}) => (
        <Callout at={s({x: STAGE.faces[3]!.x + 16, y: STAGE.faces[3]!.y - 16})} dx={250} dy={-118} in={40} out={78} size={44}>
          everyone looks away
        </Callout>
      )}
    </Shot>
  );
};

/* ----------------------------------------------------------------- B. sign up */

const SU = CLIPS.signup.ev as {click: number; step3: number; step4: number; step5: number; done: number};
/** Shot frame of the press. */
const SU_CLICK = 44;
/** The wait is ramped: real time until just after the press, fast through the claims, real again before "signed in". */
const SU_T: [number, number][] = [
  [0, SU.click - SU_CLICK],
  [SU_CLICK + 12, SU.click + 12],
  [SU_CLICK + 12 + 72, SU.done - 16],
  [SU_CLICK + 12 + 72 + 80, SU.done + 64],
];
/** Shot frame at which a clip frame is shown (inverse of the time map, by search). */
const shotFrameOf = (time: [number, number][], src: number, remapFn: (f: number) => number): number => {
  for (let f = time[0]![0]; f < 2000; f++) if (remapFn(f) >= src) return f;
  return 0;
};
import {remap} from '../anim';
const suAt = (src: number) => shotFrameOf(SU_T, src, (f) => remap(f, SU_T));
const SU_STEP3 = suAt(SU.step3);
const SU_STEP4 = suAt(SU.step4);
const SU_STEP5 = suAt(SU.step5);
const SU_DONE = suAt(SU.done);
const SU_WHIP = SU_DONE - 22;
export const SIGNUP_FRAMES = SU_DONE + 62;

const Counter: React.FC<{n: string; what: string; from: number; to: number}> = ({n, what, from, to}) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to + 6) return null;
  return (
    <div style={{position: 'absolute', left: 0, top: 0, width: 620, whiteSpace: 'nowrap'}}>
      <Rise at={from} out={to} style={{display: 'flex', alignItems: 'baseline', gap: 6, color: C.accent, ...nums(250)}}>
        {n}
        <span style={{...nums(110), color: C.white}}>/5</span>
      </Rise>
      <div style={{marginTop: 18}}>
        <Rise at={from + 3} out={to} style={label(46)}>
          {what}
        </Rise>
      </div>
    </div>
  );
};

const Signup: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Shot
        clip={CLIPS.signup}
        time={SU_T}
        cam={[
          {f: 0, v: WIDE},
          {f: 4, v: WIDE},
          // In on the button before the pointer gets there.
          {f: 34, v: [POI.button.x, 426, 2.6]},
          {f: SU_CLICK + 8, v: [POI.button.x, 426, 2.6]},
          {f: SU_CLICK + 22, v: [POI.button.x, 548, 3]},
          {f: SU_WHIP, v: [POI.button.x, 548, 3]},
          // Whip to the header while it still says "key: full access", to see it change.
          {f: SU_WHIP + 12, v: [POI.keyLink.x, 150, 3], e: E.whip},
        ]}
        win={[
          {f: SU_CLICK + 8, v: FULLW},
          {f: SU_CLICK + 22, v: SPLITW},
        ]}
      >
        {({s}) => (
          <Callout at={s({x: POI.keyLink.x, y: POI.keyLink.y + 12})} dx={0} dy={190} in={SU_DONE + 4} out={SIGNUP_FRAMES - 6} size={46}>
            changed on chain, in one transaction
          </Callout>
        )}
      </Shot>
      <PanelColumn left={COL} width={600}>
        <div style={{position: 'relative', height: 620}}>
          {frame < SU_WHIP + 8 && (
            <div style={{position: 'absolute', left: 0, top: 40}}>
              <Rise at={SU_CLICK + 14} out={SU_WHIP} style={label(92)}>
                One click.
              </Rise>
            </div>
          )}
          <div style={{position: 'absolute', left: 0, top: 190}}>
            <Counter n="3" what="claiming 1,000 NOTIT" from={Math.max(SU_STEP3, SU_CLICK + 20)} to={SU_STEP4} />
            <Counter n="4" what="claiming on the 1-hour game" from={SU_STEP4 + 5} to={SU_STEP5} />
            <Counter n="5" what="locking the key" from={SU_STEP5 + 5} to={SU_WHIP} />
          </div>
          {frame >= SU_WHIP && (
            <div style={{position: 'absolute', left: 0, top: 90, display: 'flex', flexDirection: 'column', gap: 10}}>
              <Rise at={SU_WHIP + 6} style={label(76)}>
                The key left
              </Rise>
              <Rise at={SU_WHIP + 9} style={label(76)}>
                in this browser
              </Rise>
              <Rise at={SU_DONE + 2} style={{...label(76), color: C.accent}}>
                can only
              </Rise>
              <Rise at={SU_DONE + 5} style={{...label(76), color: C.accent}}>
                volunteer.
              </Rise>
              <div style={{marginTop: 34}}>
                <Rise at={SU_DONE + 16}>
                  <Chip>{`method_names: ["${FACTS.keyMethods.join('", "')}"]`}</Chip>
                </Rise>
              </div>
            </div>
          )}
        </div>
      </PanelColumn>
    </>
  );
};

/* --------------------------------------------------------------- C. volunteer */

const VO = CLIPS.volunteer.ev as {click: number; sending: number; confirmed: number};
const VO_CLICK = 88;
const VO_CONF = VO_CLICK + (VO.confirmed - VO.click);
const VO_SPLIT = VO_CONF + 34;
export const VOLUNTEER_FRAMES = VO_SPLIT + 92;

const Volunteer: React.FC = () => (
  <>
    <Shot
      clip={CLIPS.volunteer}
      time={[[0, VO.click - VO_CLICK]]}
      cam={[
        {f: 0, v: WIDE},
        {f: 8, v: WIDE},
        // In on the falling cost, landing well before the press.
        {f: 40, v: [690, 442, 2.8]},
        {f: VO_CLICK + 40, v: [690, 442, 2.8]},
        // Out to the ring, in time to watch the face travel to the middle.
        {f: VO_CONF - 6, v: [640, 365, 2]},
        {f: VO_SPLIT, v: [640, 365, 2]},
        {f: VO_SPLIT + 14, v: [640, 380, 1.9]},
      ]}
      win={[
        {f: VO_SPLIT, v: FULLW},
        {f: VO_SPLIT + 14, v: SPLITW},
      ]}
    >
      {({s}) => (
        <>
          <Callout at={s({x: POI.cost.x + 4, y: POI.cost.y - 16})} dx={150} dy={-210} in={44} out={VO_CLICK - 8} size={46}>
            the cost falls all round
          </Callout>
          <Callout at={s({x: 500, y: 540})} dx={-40} dy={-250} in={VO_CLICK + 6} out={VO_CLICK + 44} size={44}>
            signed by the browser key
            <br />
            no wallet pop-up
          </Callout>
        </>
      )}
    </Shot>
    <PanelColumn left={COL} width={600} gap={22}>
      <Rise at={VO_SPLIT + 10} style={label(60)}>
        First to volunteer
      </Rise>
      <Rise at={VO_SPLIT + 13} style={label(60)}>
        burns the cost.
      </Rise>
      <div style={{marginTop: 14}}>
        <Numeral text={`−${FACTS.burned}`} at={VO_SPLIT + 18} size={200} color={C.accent} />
      </div>
      <Rise at={VO_SPLIT + 30} style={{...words(40, 600), color: C.white, letterSpacing: 0}}>
        NOTIT burned · round {FACTS.roundVolunteer}
      </Rise>
      <div style={{marginTop: 14, display: 'flex', gap: 14, flexWrap: 'wrap'}}>
        <Rise at={VO_SPLIT + 36}>
          <Chip>tx {FACTS.txVolunteer.slice(0, 8)}…</Chip>
        </Rise>
        <Rise at={VO_SPLIT + 40}>
          <Chip>confirmed in {FACTS.confirmSeconds} s</Chip>
        </Rise>
      </div>
    </PanelColumn>
  </>
);

/* ----------------------------------------------------------------- D. unsaved */

const UN = CLIPS.unsaved.ev as {close: number; coins: number; coinsEnd: number};
/** Fast through the wait, then the last three seconds of the round in real time. */
const UN_REAL = 72;
const UN_LEAD = 96;
const UN_T: [number, number][] = [
  [0, 20],
  [8, 28],
  [UN_REAL, UN.close - UN_LEAD],
];
const UN_CLOSE = UN_REAL + UN_LEAD;
const UN_COINS = UN_CLOSE + (UN.coins - UN.close);
const UN_SPLIT = UN_COINS + 50;
export const UNSAVED_FRAMES = UN_SPLIT + 100;

const Unsaved: React.FC = () => {
  const sc = stageCam();
  return (
    <>
      <Shot
        clip={CLIPS.unsaved}
        time={UN_T}
        cam={[
          {f: 0, v: WIDE},
          {f: UN_REAL - 22, v: WIDE},
          // In on the clock for the last seconds.
          {f: UN_REAL + 6, v: [640, 318, 2.7]},
          {f: UN_CLOSE - 2, v: [640, 318, 2.7]},
          // Out to the whole stage as the round closes: the red ring, and every face paying.
          {f: UN_CLOSE + 12, v: [sc.x, sc.y, sc.z], e: E.out},
          {f: UN_SPLIT, v: [sc.x, sc.y, sc.z]},
          {f: UN_SPLIT + 14, v: [640, 372, 1.9]},
        ]}
        win={[
          {f: UN_SPLIT, v: FULLW},
          {f: UN_SPLIT + 14, v: SPLITW},
        ]}
      >
        {({s}) => (
          <>
            <Callout at={s({x: 628, y: 362})} dx={-700} dy={24} in={12} out={UN_REAL - 26} size={46}>
              now you are It
            </Callout>
            <Callout at={s({x: 722, y: 322})} dx={300} dy={-40} in={UN_REAL + 14} out={UN_CLOSE - 6} size={50}>
              nobody volunteers
            </Callout>
          </>
        )}
      </Shot>
      <PanelColumn left={COL} width={600} gap={22}>
        <Rise at={UN_SPLIT + 10} style={label(64)}>
          Nobody did it.
        </Rise>
        <Rise at={UN_SPLIT + 13} style={label(64)}>
          Everybody paid It.
        </Rise>
        <div style={{marginTop: 14}}>
          <Numeral text={`+${FACTS.paid}`} at={UN_SPLIT + 18} size={200} color={C.accent} />
        </div>
        <Rise at={UN_SPLIT + 30} style={{...words(40, 600), color: C.white, letterSpacing: 0, lineHeight: 1.2}}>
          NOTIT, 15% of every balance · round {FACTS.roundUnsaved}
        </Rise>
        <div style={{marginTop: 14}}>
          <Rise at={UN_SPLIT + 36}>
            <Chip>
              {FACTS.balanceAfterVolunteer} → {FACTS.balanceAfterUnsaved}
            </Chip>
          </Rise>
        </div>
      </PanelColumn>
    </>
  );
};

/* -------------------------------------------------------------------- section */

export const REAL_FRAMES = WATCH_FRAMES + SIGNUP_FRAMES + VOLUNTEER_FRAMES + UNSAVED_FRAMES;

export const Real: React.FC = () => {
  const frame = useCurrentFrame();
  let at = 0;
  const next = (n: number) => {
    const from = at;
    at += n;
    return from;
  };
  return (
    <AbsoluteFill style={{backgroundColor: C.ink}}>
      <Sequence name="Watch" from={next(WATCH_FRAMES)} durationInFrames={WATCH_FRAMES}>
        <Watch />
      </Sequence>
      <Sequence name="Sign up" from={next(SIGNUP_FRAMES)} durationInFrames={SIGNUP_FRAMES}>
        <Signup />
      </Sequence>
      <Sequence name="Volunteer" from={next(VOLUNTEER_FRAMES)} durationInFrames={VOLUNTEER_FRAMES}>
        <Volunteer />
      </Sequence>
      <Sequence name="Unsaved round" from={next(UNSAVED_FRAMES)} durationInFrames={UNSAVED_FRAMES}>
        <Unsaved />
      </Sequence>
      {frame >= 26 && <Tag at={26}>{TAG}</Tag>}
    </AbsoluteFill>
  );
};
