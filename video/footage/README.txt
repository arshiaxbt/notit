Footage for the motion film — what is here and what deviated
=============================================================

All six clips are clean plates: no captions, no speed changes, real time,
2560x1440 (a 1280x720 page at device scale 2), 30 fps, H.264 CRF 12, yuv420p,
no audio. Details, frame numbers and facts are in timeline.json.

REAL TAKES (one session, 14:48-14:59 UTC on 14 Nov, NEAR testnet)
  Account guest-4e4e58bf.testnet on the locked contract notit-play.testnet
  (it also claimed on notit-live.testnet). These are not test captures.
  watch.mp4      12.1 s  the live ring, signed out, round 142, nothing touched (pointer hidden)
  signup.mp4     13.2 s  press "Play as guest", claim on Fast, claim on Live, "Locking the key", "key: volunteer only"
  volunteer.mp4  18.5 s  round 143: press "I'll do it" at 219.19 shown, "Sending", confirmed in 1.2 s, face to the middle seat
  unsaved.mp4    28.6 s  round 144 with the fast bots paused: last 17 s, the round closes, 13 faces pay, +557.40
  locked.mp4     16.4 s  the chain bar's "Locked: no access keys", then the Rules tab, rule 5

NOT THE CHAIN
  lab.mp4        24.6 s  the Lab tab of the same site (a simulation in the browser): crowd size dragged
                         from 10 to 60 holders, then the "Forward-looking" sub-tab.

FACTS (also in timeline.json under facts.realSession)
  transactions   claim on Fast  5q4xSkuKtZmFGDFeb7GzmhqHhFdnP3PdcPkZ2X57hJfq
                 claim on Live  9KSLhnLKiyHuKXX31Um2trQCF9b8NwqEWVUtXbriN545
                 key swap       4jYWgkTEav7nehr38ViB85hKMAiKmXew5Ao7nnmFEfsJ
                 volunteer      3sFHyCDFy2qoywtfzbhoirSgYrCt1vBT47m6CV1ZmysX
  burned 216.73 NOTIT; paid to It 557.40 NOTIT
  balance 1,000.00 -> 783.26 (after volunteering) -> 1,340.67 (after the unsaved round)

DEVIATIONS
  * Not recorded (dropped from scope): phone, demo-seat-swap, demo-unsaved, demo-asleep.
  * signup: the account had been created by the faucet beforehand. Its key was put into the
    browser's storage in the instant of the press, so the button reads "Play as guest" and the
    app carries on from "account exists" (step 1/5 passes at once; the film shows 3/5, 4/5, 5/5).
  * volunteer: "burned" was not yet in the page's table when the clip ended; 216.73 was read
    from the contract afterwards (get_account). The page's balance figures give 1,000.00 - 783.26.
  * unsaved: starts 17 s before the round closes (asked: 15 s) and runs 10 s after it.
    "Paid to It" in the table was read from the contract afterwards (557.40); on screen the line
    under the button says "you collected 557.40" and the balance figure rolls up.
  * Pointer positions in timeline.json are in page pixels (1280x720): multiply by 2 for video
    pixels. For an event logged while the pointer was still gliding away from a press, the
    position is where the pointer comes to rest, not where it was in that frame. In lab.mp4 the
    "dragging" positions are exact.
  * Captured frames arrive at 15-30 per second (the page redraws at that rate) and are held to a
    steady 30 fps; nothing is sped up or slowed down.
  * watch, signup, volunteer, unsaved and locked were filmed on the build that was live at the
    time; lab was filmed a few minutes later on a newer local build that adds the curve drawing
    on, the points arriving in order and the gliding marker.
  * The fast bots were paused from the sign-up (14:51:39 UTC) to the end of the unsaved round
    (14:58:21 UTC) and restarted; they are running.
