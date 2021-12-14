import React from 'react'
import { kernel, useVibes } from '../db.js'
import CountDownTimer from './CountDown.jsx'

export default function VibeList () {
  const vibes = useVibes()
  console.log('Vibe.jsx, vibes:', vibes)
  const respondToVibe = (id, didLike) => {
    kernel.respondVibe(id, didLike)
      .then(() => {
        console.log('vibe sent', id)
      })
      .catch(err => {
        console.log('failed creating vibe', err)
      })
  }

  return (
    <>
      <ul className='column'>
        {vibes.map(vibe => {
          console.log('Vibe.jsx vibe.peer', vibe.peer)
          return (
            <li key={vibe.id}>
              {vibe.state === 'waiting_local' && (
                <div className='column'>
                  <span>⌛ You got one Vibe from
                    <strong>{vibe.peer.name}</strong>
                    <CountDownTimer expiresAt={vibe.expiresAt} />
                  </span>
                  <button
                    className='button'
                    onClick={() => respondToVibe(vibe.id, false)}
                  >👎
                  </button>
                  <button
                    className='button like-zoom'
                    onClick={() => respondToVibe(vibe.id, true)}
                  >👍
                  </button>
                </div>
              )}
              {vibe.state === 'match' && (
                <a href={`#/chat/${vibe.id.toString('hex')}`}>
                  ❤️ {vibe.peer.name} accepted
                  <CountDownTimer expiresAt={vibe.expiresAt} />
                </a>
              )}
              {vibe.state === 'waiting_remote' && (
                <span>⌛Waiting for
                  <strong>{vibe.peer.name}</strong>
                  <span><CountDownTimer expiresAt={vibe.expiresAt || 0} /></span>
                </span>
              )}
              {vibe.state === 'rejected' && (
                <span>💔<strong>{vibe.peer.name}</strong> rejected</span>
              )}
            </li>
          )
        })}

      </ul>
    </>
  )
}
