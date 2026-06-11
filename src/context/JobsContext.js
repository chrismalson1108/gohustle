import React, { createContext, useContext, useReducer } from 'react';
import { MOCK_JOBS } from '../data/mockData';

// TODO: persist with AsyncStorage

const JobsContext = createContext(null);

function reducer(state, action) {
  switch (action.type) {
    case 'BOOK_JOB':
      return {
        ...state,
        jobs: state.jobs.map(j => {
          if (j.id !== action.jobId) return j;
          return {
            ...j,
            slots: j.slots.map(s =>
              s.id === action.slotId ? { ...s, taken: true } : s
            ),
          };
        }),
        bookings: [...state.bookings, {
          jobId: action.jobId,
          slotId: action.slotId,
          slotLabel: action.slotLabel || null,
          counterOffer: action.counterOffer || null,
        }],
      };

    case 'ADD_JOB': {
      const newJob = {
        ...action.job,
        id: String(Date.now()),
        postedAt: 'Just now',
        status: 'open',
        reviews: [],
        poster: {
          name: 'You',
          avatarInitial: 'Y',
          rating: 4.8,
          reviewCount: 9,
          verified: true,
        },
      };
      return {
        ...state,
        jobs: [newJob, ...state.jobs],
        myPostedIds: [...state.myPostedIds, newJob.id],
      };
    }

    default:
      return state;
  }
}

export function JobsProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, {
    jobs: MOCK_JOBS,
    bookings: [],
    myPostedIds: [],
  });

  const bookJob = (jobId, slotId, slotLabel, counterOffer) =>
    dispatch({ type: 'BOOK_JOB', jobId, slotId, slotLabel, counterOffer });

  const addJob = (jobData) =>
    dispatch({ type: 'ADD_JOB', job: jobData });

  const isBooked = (jobId) =>
    state.bookings.some(b => b.jobId === jobId);

  const bookedJobIds = state.bookings.map(b => b.jobId);
  const bookedJobs   = state.jobs.filter(j => bookedJobIds.includes(j.id));
  const postedJobs   = state.jobs.filter(j => state.myPostedIds.includes(j.id));

  return (
    <JobsContext.Provider value={{
      ...state,
      bookJob,
      addJob,
      isBooked,
      bookedJobs,
      postedJobs,
    }}>
      {children}
    </JobsContext.Provider>
  );
}

export const useJobs = () => useContext(JobsContext);
