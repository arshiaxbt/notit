import React from 'react';
import {Composition, Folder} from 'remotion';
import {Film, FILM_FRAMES} from './Film';
import {ColdOpen, COLD_OPEN_FRAMES} from './scenes/ColdOpen';
import {EndCard, END_CARD_FRAMES} from './scenes/EndCard';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="Film" component={Film} width={1920} height={1080} fps={30} durationInFrames={FILM_FRAMES} />
      <Folder name="Scenes">
        <Composition id="ColdOpen" component={ColdOpen} width={1920} height={1080} fps={30} durationInFrames={COLD_OPEN_FRAMES} />
        <Composition id="EndCard" component={EndCard} width={1920} height={1080} fps={30} durationInFrames={END_CARD_FRAMES} />
      </Folder>
    </>
  );
};
