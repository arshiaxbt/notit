# Not It: shot list (as built)

1920×1080, 30 fps, 1532 frames = 51.1 s, no audio. Frame numbers are film frames; `t` is seconds.
Footage is on screen for 39.7 s of the 51.1 s (78 %; 36.0 s of it the real session, 3.7 s the lab): five plates of one real session on NEAR testnet
(`guest-4e4e58bf.testnet` on the locked contract `notit-play.testnet`, rounds 142–144) and the lab plate
(the site's in-browser simulation, tagged as such). Every number comes from `footage/timeline.json`
via `src/footage.ts`.

| # | Frames | t | Shot | Source | What happens |
|---|---|---|---|---|---|
| 1 | 0–163 | 0.0–5.5 | Cold open | motion graphics, flat yellow | Thirteen faces pop onto a ring looking at you. "Somebody has to do it." lands word by word; on "it." every face looks away and flinches (the joke, first time). "If nobody does, everybody pays the last person who did."; one face steals a glance at the middle. The type leaves; It (ink, yellow eyes on you) pops in the middle and every face pays it a coin. The clock ring draws on round It, the faces glide into the exact formation of the app, the fuse burns. |
| 2 | 164–247 | 5.5–8.3 | Watch | `watch` (real, round 142) | Match cut on the fuse: the same ring, now the real app, full-frame on the stage; the camera pulls back to show the page. Tag "real session · NEAR testnet" comes on and stays. Callout on a real face: "everyone looks away" (second time). |
| 3 | 248–453 | 8.3–15.1 | Sign up | `signup` (real) | Push in on "Play as guest" ahead of the pointer; the press at f292. The plate slides left, ink column: "One click." and a counter 3/5, 4/5, 5/5 in step with the page's own steps (claiming 1,000 NOTIT, claiming on the 1-hour game, locking the key), ramped ×2.5 with the speed badge. Whip to the header while it still reads "key: full access"; it flips to "key: volunteer only" (f392). Column: "The key left in this browser can only volunteer." and the chip `method_names: ["volunteer", "poke"]`; callout "changed on chain, in one transaction". |
| 4 | 454–728 | 15.1–24.3 | Volunteer | `volunteer` (real, round 143) | Wide, then in on the falling cost on the button: "the cost falls all round". The press at f542 (cost shown 219.19); "Sending": "signed by the browser key / no wallet pop-up". Out to the ring in time for the confirmation (f603): your face travels to the middle seat, the app stamps "You did it". Hold; plate slides left, column: "First to volunteer burns the cost." −216.73, "NOTIT burned · round 143", chips "tx 3sFHyCDF…" and "confirmed in 1.2 s". |
| 5 | 729–1065 | 24.3–35.5 | The unsaved round | `unsaved` (real, round 144) | "now you are It". The wait runs at ×7 (badge) to three seconds before the close, then real time, tight on the clock: 0:03, 0:02, 0:01, "nobody volunteers". The round closes (f897); out to the whole stage for the red ring and thirteen faces paying coins to the middle (f916–945), "you collected 557.40" on the page. Plate slides left, column: "Nobody did it. Everybody paid It." +557.40, "NOTIT, 15% of every balance · round 144", chip "783.26 → 1,340.67". |
| 6 | 1066–1143 | 35.5–38.1 | No admin | `locked` (real) | The app's own stamp, large: "No admin." over the chain bar, while the camera goes in on "Locked: no access keys". |
| 7 | 1144–1243 | 38.1–41.5 | Keys | `locked` (real), Rules tab | Rule 5 on the page; an ink line draws under "Checked just now: this contract account has no access keys." Column: `view_access_key_list` / `notit-play.testnet` / `"keys": []` / "No key, no owner, no way to change the rules." |
| 8 | 1244–1355 | 41.5–45.2 | Lab | `lab` (simulation, not the chain) | Tag changes to "lab · simulation in the browser". The crowd-size slider is dragged from 10 to 60 holders at ×5 (badge), the marker rides the curve: "simulated against the equilibrium". Settle on the page's reading: "With 60 holders nobody volunteered in 69.8% of 500 rounds; the equilibrium says 66.4%." |
| 9 | 1342–1531 | 44.7–51.1 | End card | motion graphics | Iris from the middle. The ring again, everyone looking away, It in the middle looking at you (third time; one face checks, It is still looking). "Not It", "$NOTIT · built at NEAR HACKATHON", arshiaxbt.github.io/notit, "testnet · test tokens · no value", "made by @0xarshia". Everything is still for the last 2.1 s. |

## Motion rules

- Camera moves start before the action and land on it; holds on results.
- One idea on screen at a time; captions are labels on the thing (the app's own white box and ink stroke)
  or large type in an ink column beside the plate, never a subtitle band.
- Numbers condensed (width 75), words at normal width, both Bricolage Grotesque, as in the app.
- Flat colour only: accent yellow, ink, paper white, and red only where the app uses it.
- Speed changes always carry the badge with the true average rate of the fast stretch.
