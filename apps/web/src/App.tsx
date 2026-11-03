import {
  Alert,
  Card,
  Container,
  Flex,
  Heading,
  SimpleGrid,
  Spinner,
  Text,
} from '@chakra-ui/react';
import type { Trip } from '@travel-agent/shared';
import { useEffect, useState } from 'react';
import { fetchTrips } from './api.ts';
import { ColorModeButton } from './components/ui/color-mode.tsx';

export default function App() {
  const [trips, setTrips] = useState<Trip[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchTrips(controller.signal)
      .then(setTrips)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(String(err));
      });
    return () => controller.abort();
  }, []);

  return (
    <Container maxW="4xl" py="10">
      <Flex justify="space-between" align="center" mb="8">
        <Heading size="2xl">Travel Agent</Heading>
        <ColorModeButton />
      </Flex>

      {error && (
        <Alert.Root status="error">
          <Alert.Indicator />
          <Alert.Title>{error}</Alert.Title>
        </Alert.Root>
      )}

      {!trips && !error && <Spinner size="lg" />}

      {trips && (
        <SimpleGrid columns={{ base: 1, md: 2 }} gap="4">
          {trips.map((trip) => (
            <Card.Root key={trip.id}>
              <Card.Body>
                <Card.Title>{trip.destination}</Card.Title>
                <Text color="fg.muted">
                  {trip.startDate} → {trip.endDate}
                </Text>
              </Card.Body>
            </Card.Root>
          ))}
        </SimpleGrid>
      )}
    </Container>
  );
}
