import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'
  | 'look-left'
  | 'look-right'

type Props = {
  pose?: ClawdPose
}

// Edit just these 3-line poses when you want to try a new WrapdCode mascot.
const CLAWD_ART: Record<ClawdPose, string[]> = {
  default: [' ▄█████▄ ', ' █ o o █ ', ' ▀█╹ ╹█▀ '],
  'look-left': [' ▄█████▄ ', ' █ oo  █ ', ' ▀█╹ ╹█▀ '],
  'look-right': [' ▄█████▄ ', ' █  oo █ ', ' ▀█╹ ╹█▀ '],
  'arms-up': ['▄█     █▄', ' █ o o █ ', '  ▀███▀  '],
}

export function Clawd({ pose = 'default' }: Props) {
  const art = CLAWD_ART[pose]

  return (
    <Box flexDirection="column" alignItems="center">
      {art.map((line, index) => (
        <Text key={`${pose}-${index}`} color="clawd_body">
          {line}
        </Text>
      ))}
    </Box>
  )
}
